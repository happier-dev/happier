//! The held Agent in a pseudo-terminal (`serve --pty <cols>x<rows>`), through the real
//! executable and socket: terminal output is sequenced on the Agent's own outbox, so a
//! client that drops without acknowledging (a runner crash) gets exactly the
//! unacknowledged bytes again on the next attach, and `resize` reaches the terminal.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![kind];
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

struct Client {
    stream: UnixStream,
    hello: serde_json::Value,
}

/// Agent output frames (`o`) by sequence, plus the exit (`x`) and replies (`r`).
#[derive(Default)]
struct Seen {
    output: Vec<(u64, Vec<u8>)>,
    exit: Option<serde_json::Value>,
    /// `z`: every writer of the Agent's output is gone; nothing follows it.
    closed: bool,
    replies: Vec<serde_json::Value>,
}

impl Seen {
    fn text(&self) -> String {
        self.output.iter().map(|(_, bytes)| String::from_utf8_lossy(bytes).into_owned()).collect()
    }
    fn last_seq(&self) -> u64 {
        self.output.last().map_or(0, |(seq, _)| *seq)
    }
}

impl Client {
    fn connect(socket: &str) -> Client {
        // The workspace socket is bound just after the readiness line.
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(error) if Instant::now() < deadline && error.kind() == std::io::ErrorKind::NotFound => std::thread::sleep(Duration::from_millis(10)),
                Err(error) => panic!("connect holder: {error}"),
            }
        };
        stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        let (kind, payload) = read_frame_blocking(&mut stream, Instant::now() + Duration::from_secs(10)).expect("hello");
        assert_eq!(kind, b'H');
        Client { stream, hello: serde_json::from_slice(&payload).unwrap() }
    }

    fn send(&mut self, kind: u8, payload: &[u8]) {
        self.stream.write_all(&frame(kind, payload)).unwrap();
    }

    fn ack(&mut self, seq: u64) {
        self.send(b'a', &seq.to_be_bytes());
    }

    /// Reads frames into `seen` until `done` holds (or the deadline passes).
    fn read_until(&mut self, seen: &mut Seen, done: impl Fn(&Seen) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done(seen) && Instant::now() < deadline {
            let Some((kind, payload)) = read_frame_blocking(&mut self.stream, deadline) else { break };
            match kind {
                b'o' => seen.output.push((u64::from_be_bytes(payload[..8].try_into().unwrap()), payload[8..].to_vec())),
                b'x' => seen.exit = Some(serde_json::from_slice(&payload[8..]).unwrap()),
                b'z' => seen.closed = true,
                b'r' => seen.replies.push(serde_json::from_slice(&payload).unwrap()),
                _ => {}
            }
        }
    }
}

fn read_frame_blocking(stream: &mut UnixStream, deadline: Instant) -> Option<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    read_exact_until(stream, &mut header, deadline)?;
    let mut payload = vec![0u8; u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize];
    read_exact_until(stream, &mut payload, deadline)?;
    Some((header[0], payload))
}

fn read_exact_until(stream: &mut UnixStream, buffer: &mut [u8], deadline: Instant) -> Option<()> {
    let mut filled = 0;
    while filled < buffer.len() {
        if Instant::now() > deadline {
            return None;
        }
        match stream.read(&mut buffer[filled..]) {
            Ok(0) => return None,
            Ok(n) => filled += n,
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(_) => return None,
        }
    }
    Some(())
}

#[test]
fn held_agent_terminal_replays_unacknowledged_output_and_takes_resize_and_input() {
    let directory = std::env::temp_dir().join(format!("hh-pty-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("h.sock").to_string_lossy().into_owned();
    // Prints whether it has a terminal and its size; then echoes each line with the size.
    let script = "test -t 0 && test -t 1 && echo tty; stty size; while read line; do echo got:$line; stty size; done; exit 7";
    let mut holder = Command::new(env!("CARGO_BIN_EXE_happier-session-holder"))
        .args(["serve", "--socket", &socket, "--pty", "100x30", "--", "sh", "-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(holder.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&ready).unwrap_or_else(|_| panic!("readiness line: {ready:?}"));
    assert_eq!(ready["ready"], true, "{ready}");

    // Runner 1: sees the terminal at its start size and acknowledges it.
    let mut first = Client::connect(&socket);
    assert_eq!(first.hello["agentPid"], ready["agentPid"]);
    let mut seen = Seen::default();
    first.read_until(&mut seen, |seen| seen.text().contains("30 100"));
    assert!(seen.text().contains("tty") && seen.text().contains("30 100"), "{:?}", seen.text());
    let acknowledged = seen.last_seq();
    first.ack(acknowledged);
    // Resize reaches the Agent's terminal; input reaches its line discipline.
    first.send(b'q', br#"{"id":"r1","op":"resize","cols":120,"rows":40}"#);
    first.send(b'i', b"one\r");
    let mut unacknowledged = Seen::default();
    first.read_until(&mut unacknowledged, |seen| seen.text().contains("40 120"));
    assert_eq!(unacknowledged.replies.first().map(|reply| reply["ok"].clone()), Some(serde_json::Value::Bool(true)));
    assert!(unacknowledged.text().contains("got:one"), "{:?}", unacknowledged.text());
    // Runner 1 dies without acknowledging the rest.
    drop(first);

    // Runner 2: exactly the unacknowledged bytes again, nothing it already took.
    let mut second = Client::connect(&socket);
    assert_eq!(second.hello["replayFrom"].as_u64(), Some(acknowledged + 1));
    let mut replay = Seen::default();
    second.read_until(&mut replay, |seen| seen.last_seq() >= unacknowledged.last_seq());
    assert_eq!(replay.output, unacknowledged.output);
    second.ack(replay.last_seq());
    // The same Agent keeps running: more input, then end of input (Ctrl-D) ends it.
    second.send(b'i', b"two\r\x04");
    let mut rest = Seen::default();
    second.read_until(&mut rest, |seen| seen.closed);
    assert!(rest.text().contains("got:two"), "{:?}", rest.text());
    assert_eq!(rest.exit.as_ref().map(|exit| exit["code"].clone()), Some(serde_json::json!(7)));
    second.ack(u64::MAX);
    let status = holder.wait().unwrap();
    assert!(status.success());
    assert!(!std::path::Path::new(&socket).exists());
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn a_workspace_client_cannot_resize_the_held_agent_terminal() {
    let directory = std::env::temp_dir().join(format!("hh-pty-ws-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let socket = directory.join("h.sock").to_string_lossy().into_owned();
    let mut holder = Command::new(env!("CARGO_BIN_EXE_happier-session-holder"))
        .args(["serve", "--socket", &socket, "--pty", "80x24", "--", "sh", "-c", "read line"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(holder.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let mut workspace = Client::connect(&format!("{socket}.ops"));
    assert_eq!(workspace.hello["role"], "workspace");
    workspace.send(b'q', br#"{"id":"w","op":"resize","cols":10,"rows":5}"#);
    let mut seen = Seen::default();
    workspace.read_until(&mut seen, |seen| !seen.replies.is_empty());
    assert_eq!(seen.replies[0]["ok"], false, "{:?}", seen.replies);
    drop(workspace);
    let mut primary = Client::connect(&socket);
    primary.send(b'q', br#"{"id":"k","op":"signal","signal":"KILL"}"#);
    let mut end = Seen::default();
    primary.read_until(&mut end, |seen| seen.closed);
    primary.ack(u64::MAX);
    holder.wait().unwrap();
    let _ = std::fs::remove_dir_all(directory);
}
