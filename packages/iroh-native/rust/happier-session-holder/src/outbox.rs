//! The holder's raw-output replay window.
//!
//! Output frames stay here until the attached client acknowledges them. The client
//! acknowledges only after it has handed that output to the Session's own outbox, so
//! this is not a second message queue: it holds raw Agent bytes the Session has not
//! taken yet. While no client is attached, `send` blocks, the pipe readers stop and the
//! Agent meets ordinary pipe backpressure; the window is bounded by that, not by a cap.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Condvar, Mutex};

use crate::frame::{encode, encode_sequenced, write_frame};

pub trait ClientWriter: Write + Send {
    /// Ends the connection so its reader thread returns (a newer client replaced it).
    fn close(&mut self);
}

struct State {
    client: Option<(u64, Box<dyn ClientWriter>)>,
    generation: u64,
    next_seq: u64,
    unacked: VecDeque<(u64, Vec<u8>)>,
    exit_queued: bool,
}

pub struct Outbox {
    state: Mutex<State>,
    changed: Condvar,
}

impl Default for Outbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Outbox {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State { client: None, generation: 0, next_seq: 1, unacked: VecDeque::new(), exit_queued: false }),
            changed: Condvar::new(),
        }
    }

    /// Sequences one output frame, keeps it until acknowledged and writes it to the
    /// attached client. Blocks while no client is attached (backpressure).
    pub fn send(&self, kind: u8, data: &[u8]) {
        let state = self.state.lock().unwrap();
        let mut state = self.changed.wait_while(state, |state| state.client.is_none()).unwrap();
        self.push(&mut state, kind, data);
    }

    /// Like `send`, but never waits for a client: used after the Agent's exit
    /// frame, when nothing is left to backpressure.
    pub fn send_if_attached(&self, kind: u8, data: &[u8]) {
        let mut state = self.state.lock().unwrap();
        self.push(&mut state, kind, data);
    }

    fn push(&self, state: &mut State, kind: u8, data: &[u8]) {
        let seq = state.next_seq;
        state.next_seq += 1;
        if kind == b'x' {
            state.exit_queued = true;
        }
        let frame = encode_sequenced(kind, seq, data);
        let failed = match state.client.as_mut() {
            Some((_, writer)) => write_frame(writer.as_mut(), &frame).is_err(),
            None => false,
        };
        state.unacked.push_back((seq, frame));
        if failed {
            // The client went away; the frame stays for the next attach to replay.
            if let Some((_, mut writer)) = state.client.take() {
                writer.close();
            }
            self.changed.notify_all();
        }
    }

    /// Replaces the attached client: writes `hello`, then replays every frame the
    /// previous client never acknowledged. Returns this attachment's generation.
    pub fn attach(&self, mut writer: Box<dyn ClientWriter>, hello: impl FnOnce(u64) -> Vec<u8>) -> Option<u64> {
        let mut state = self.state.lock().unwrap();
        let replay_from = state.unacked.front().map_or(state.next_seq, |(seq, _)| *seq);
        let mut ok = write_frame(writer.as_mut(), &encode(b'H', &hello(replay_from))).is_ok();
        for (_, frame) in state.unacked.iter() {
            if !ok {
                break;
            }
            ok = write_frame(writer.as_mut(), frame).is_ok();
        }
        if !ok {
            writer.close();
            return None;
        }
        state.generation += 1;
        let generation = state.generation;
        if let Some((_, mut previous)) = state.client.replace((generation, writer)) {
            previous.close();
        }
        self.changed.notify_all();
        Some(generation)
    }

    /// The reader of attachment `generation` ended.
    pub fn detach(&self, generation: u64) {
        let mut state = self.state.lock().unwrap();
        if state.client.as_ref().map(|(current, _)| *current) == Some(generation) {
            if let Some((_, mut writer)) = state.client.take() {
                writer.close();
            }
            self.changed.notify_all();
        }
    }

    /// Cumulative acknowledgement: frames up to `seq` were taken by the Session.
    pub fn ack(&self, seq: u64) {
        let mut state = self.state.lock().unwrap();
        while state.unacked.front().is_some_and(|(queued, _)| *queued <= seq) {
            state.unacked.pop_front();
        }
        self.changed.notify_all();
    }

    /// Writes an unsequenced operation reply to the current client, if any.
    pub fn reply(&self, generation: u64, payload: &[u8]) {
        let mut state = self.state.lock().unwrap();
        if let Some((current, writer)) = state.client.as_mut() {
            if *current == generation {
                let _ = write_frame(writer.as_mut(), &encode(b'r', payload));
            }
        }
    }

    /// Returns once the Session has accepted the final output, including exit.
    /// A detached client leaves the same replay tail for its successor.
    pub fn wait_exit_acknowledged(&self) {
        let state = self.state.lock().unwrap();
        let _state = self
            .changed
            .wait_while(state, |state| !(state.exit_queued && state.unacked.is_empty()))
            .unwrap();
    }

    #[cfg(test)]
    pub fn unacked_len(&self) -> usize {
        self.state.lock().unwrap().unacked.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::read_frame;
    use std::sync::{Arc, Mutex as StdMutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<StdMutex<(Vec<u8>, bool)>>);
    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut inner = self.0.lock().unwrap();
            if inner.1 {
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            inner.0.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl ClientWriter for Sink {
        fn close(&mut self) {
            self.0.lock().unwrap().1 = true;
        }
    }
    impl Sink {
        fn frames(&self) -> Vec<(u8, Vec<u8>)> {
            let bytes = self.0.lock().unwrap().0.clone();
            let mut reader = bytes.as_slice();
            let mut frames = Vec::new();
            while let Some(frame) = read_frame(&mut reader).unwrap() {
                frames.push(frame);
            }
            frames
        }
        fn break_pipe(&self) {
            self.0.lock().unwrap().1 = true;
        }
    }
    fn seqs(frames: &[(u8, Vec<u8>)]) -> Vec<u64> {
        frames.iter().filter(|(kind, _)| *kind != b'H').map(|(_, p)| u64::from_be_bytes(p[..8].try_into().unwrap())).collect()
    }

    #[test]
    fn a_new_client_receives_exactly_the_unacknowledged_frames() {
        let outbox = Outbox::new();
        let first = Sink::default();
        outbox.attach(Box::new(first.clone()), |_| b"{}".to_vec()).unwrap();
        for n in 0..5u8 {
            outbox.send(b'o', &[n]);
        }
        outbox.ack(2);
        first.break_pipe();
        // Written into a dead client: kept, not lost.
        outbox.send(b'o', &[5]);

        let second = Sink::default();
        let mut replay_from = 0;
        outbox.attach(Box::new(second.clone()), |from| {
            replay_from = from;
            b"{}".to_vec()
        }).unwrap();
        assert_eq!(replay_from, 3);
        assert_eq!(seqs(&second.frames()), vec![3, 4, 5, 6]);
        outbox.ack(6);
        assert_eq!(outbox.unacked_len(), 0);
    }

    #[test]
    fn detached_final_tail_stays_until_replayed_and_acknowledged() {
        let outbox = Arc::new(Outbox::new());
        let generation = outbox.attach(Box::new(Sink::default()), |_| b"{}".to_vec()).unwrap();
        outbox.send(b'o', b"last chunk");
        outbox.send(b'x', b"{}");
        outbox.detach(generation);
        outbox.send_if_attached(b'z', b"{}");
        let waiter = {
            let outbox = outbox.clone();
            std::thread::spawn(move || outbox.wait_exit_acknowledged())
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        let still_waiting = !waiter.is_finished();
        let second = Sink::default();
        outbox.attach(Box::new(second.clone()), |_| b"{}".to_vec()).unwrap();
        let replay = second.frames();
        outbox.ack(3);
        waiter.join().unwrap();
        assert!(still_waiting);
        assert_eq!(seqs(&replay), vec![1, 2, 3]);
        assert_eq!(replay.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(), b"Hoxz");
        assert_eq!(&replay[1].1[8..], b"last chunk");
    }

    #[test]
    fn a_new_attach_closes_the_previous_connection() {
        // Some exec channels never notice their client died; the holder ends the
        // old connection itself so its in-target `attach` process exits.
        let outbox = Outbox::new();
        let first = Sink::default();
        outbox.attach(Box::new(first.clone()), |_| b"{}".to_vec()).unwrap();
        outbox.attach(Box::new(Sink::default()), |_| b"{}".to_vec()).unwrap();
        assert!(first.0.lock().unwrap().1);
    }

    #[test]
    fn send_blocks_without_a_client_until_one_attaches() {
        let outbox = Arc::new(Outbox::new());
        let sender = {
            let outbox = outbox.clone();
            std::thread::spawn(move || outbox.send(b'o', b"late"))
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!sender.is_finished());
        let client = Sink::default();
        outbox.attach(Box::new(client.clone()), |_| b"{}".to_vec()).unwrap();
        sender.join().unwrap();
        assert_eq!(seqs(&client.frames()), vec![1]);
    }

    #[test]
    fn exit_waits_for_its_acknowledgement() {
        let outbox = Arc::new(Outbox::new());
        outbox.attach(Box::new(Sink::default()), |_| b"{}".to_vec()).unwrap();
        outbox.send(b'x', b"{}");
        let waiter = {
            let outbox = outbox.clone();
            std::thread::spawn(move || outbox.wait_exit_acknowledged())
        };
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!waiter.is_finished());
        outbox.ack(1);
        waiter.join().unwrap();
    }
}
