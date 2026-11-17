//! Windows: the held Agent in the OS pseudoconsole (`serve --pty`), through the real
//! executable, its named pipe and `attach` (the bridge a client uses). The console has the
//! requested size, `resize` reaches it, input reaches the Agent's console, a client that
//! drops without acknowledging gets exactly the unacknowledged output again, and the exit
//! status is reported.
#![cfg(windows)]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

const HOLDER: &str = env!("CARGO_BIN_EXE_happier-session-holder");

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut bytes = vec![kind];
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

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

static CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// One client: `holder attach` with its frames read on a thread.
struct Client {
    process: Child,
    input: ChildStdin,
    frames: Receiver<(u8, Vec<u8>)>,
    hello: serde_json::Value,
}

impl Client {
    fn connect(socket: &str) -> Client {
        CONNECTIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut process = Command::new(HOLDER).args(["attach", "--socket", socket])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let input = process.stdin.take().unwrap();
        let mut stdout = process.stdout.take().unwrap();
        let (sender, frames) = channel();
        std::thread::spawn(move || loop {
            let mut header = [0u8; 5];
            if stdout.read_exact(&mut header).is_err() { break; }
            let mut payload = vec![0u8; u32::from_be_bytes(header[1..5].try_into().unwrap()) as usize];
            if stdout.read_exact(&mut payload).is_err() { break; }
            if sender.send((header[0], payload)).is_err() { break; }
        });
        let Ok((kind, hello)) = frames.recv_timeout(Duration::from_secs(10)) else {
            let mut error = String::new();
            let _ = process.stderr.take().unwrap().read_to_string(&mut error);
            panic!("no hello from {socket} (connection {}): {error}", CONNECTIONS.load(std::sync::atomic::Ordering::SeqCst));
        };
        assert_eq!(kind, b'H');
        Client { process, input, frames, hello: serde_json::from_slice(&hello).unwrap() }
    }

    fn send(&mut self, kind: u8, payload: &[u8]) {
        self.input.write_all(&frame(kind, payload)).unwrap();
        self.input.flush().unwrap();
    }

    fn read_until(&mut self, seen: &mut Seen, done: impl Fn(&Seen) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done(seen) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.frames.recv_timeout(left) {
                Ok((b'o', payload)) => seen.output.push((u64::from_be_bytes(payload[..8].try_into().unwrap()), payload[8..].to_vec())),
                Ok((b'x', payload)) => seen.exit = Some(serde_json::from_slice(&payload[8..]).unwrap()),
                Ok((b'z', _)) => seen.closed = true,
                Ok((b'r', payload)) => seen.replies.push(serde_json::from_slice(&payload).unwrap()),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    fn drop_without_acknowledging(mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

/// The text without VT control sequences (the pseudoconsole renders with them).
fn plain(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' { out.push(ch); continue; }
        match chars.next() {
            Some('[') => { while let Some(next) = chars.next() { if ('@'..='~').contains(&next) { break; } } }
            Some(']') => { while let Some(next) = chars.next() { if next == '\u{7}' { break; } } }
            _ => {}
        }
    }
    out
}

/// The console's size as `mode con` prints it, for each `mode con` in the output.
fn sizes(text: &str) -> Vec<(u32, u32)> {
    let text = plain(text);
    let number = |line: &str| line.rsplit(':').next().and_then(|value| value.trim().parse::<u32>().ok());
    let lines: Vec<&str> = text.lines().collect();
    let mut found = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("Lines:") {
            if let (Some(rows), Some(cols)) = (number(line), lines.get(index + 1).and_then(|next| number(next))) {
                found.push((cols, rows));
            }
        }
    }
    found
}

#[test]
fn held_agent_pseudoconsole_takes_size_resize_and_input_and_replays_unacknowledged_output() {
    let socket = format!(r"\\.\pipe\happier-holder-{:024x}", std::process::id() as u128 * 7919);
    // `mode con` prints the console size; `set /p` reads one line from the console.
    // The Agent keeps running after the first line (a runner that dies while the Agent runs is
    // the case under test); the second line ends it.
    let script = "mode con & set /p line=? & mode con & echo got:!line! & set /p two=? & echo got:!two! & exit 7";
    let mut holder = Command::new(HOLDER)
        .args(["serve", "--socket", &socket, "--pty", "100x30", "--", "cmd.exe", "/v:on", "/d", "/c", script])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(holder.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let ready: serde_json::Value = serde_json::from_str(&ready).unwrap_or_else(|_| panic!("readiness line: {ready:?}"));
    assert_eq!(ready["ready"], true, "{ready}");

    let mut first = Client::connect(&socket);
    assert_eq!(first.hello["agentPid"], ready["agentPid"]);
    let mut seen = Seen::default();
    // Until `mode con` printed and `set /p` shows its prompt.
    first.read_until(&mut seen, |seen| { let text = plain(&seen.text()); text.contains("Columns") && text.trim_end().ends_with('?') });
    assert_eq!(sizes(&seen.text()).first(), Some(&(100, 30)), "{:?}", seen.text());
    let acknowledged = seen.last_seq();
    first.send(b'a', &acknowledged.to_be_bytes());
    first.send(b'q', br#"{"id":"r1","op":"resize","cols":120,"rows":40}"#);
    first.send(b'i', b"one\r");
    let mut unacknowledged = Seen::default();
    first.read_until(&mut unacknowledged, |seen| { let text = plain(&seen.text()); text.contains("got:one") && text.trim_end().ends_with('?') });
    assert_eq!(unacknowledged.replies.first().map(|reply| reply["ok"].clone()), Some(serde_json::Value::Bool(true)));
    assert!(sizes(&unacknowledged.text()).contains(&(120, 40)), "{:?}", unacknowledged.text());
    first.drop_without_acknowledging();

    let mut second = Client::connect(&socket);
    assert_eq!(second.hello["replayFrom"].as_u64(), Some(acknowledged + 1));
    let mut replay = Seen::default();
    second.read_until(&mut replay, |seen| seen.last_seq() >= unacknowledged.last_seq());
    assert_eq!(&replay.output[..unacknowledged.output.len()], &unacknowledged.output[..]);
    second.send(b'a', &replay.last_seq().to_be_bytes());
    // The same Agent keeps running: the next line reaches it and ends it.
    second.send(b'i', b"two\r");
    // The exit is reported when it happens; the pseudoconsole's last rendering follows once it
    // closes, then `z`. The holder leaves when everything up to `z` is acknowledged.
    second.read_until(&mut replay, |seen| seen.closed);
    assert!(plain(&replay.text()).contains("got:two"), "{:?}", replay.text());
    assert_eq!(replay.exit.as_ref().map(|exit| exit["code"].clone()), Some(serde_json::json!(7)));
    second.send(b'a', &u64::MAX.to_be_bytes());
    assert!(exits_within(&mut holder, Duration::from_secs(20)).success());
}

/// The holder's exit status, or a test failure (not a hung run) when it does not leave.
fn exits_within(holder: &mut Child, limit: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = holder.try_wait().unwrap() { return status; }
        if Instant::now() > deadline {
            let _ = holder.kill();
            panic!("the holder did not leave after its exit was acknowledged");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Evidence probe (P03-DIAG-900): which VT sequences the pseudoconsole emits when an Agent
/// writes Claude's recorded output. Run with `--ignored`, `HPTY_PROBE_FILE` (bytes to write)
/// and `HPTY_PROBE_OUT` (where the rendered bytes go).
#[test]
#[ignore]
fn pseudoconsole_rendering_probe() {
    let (Ok(file), Ok(out)) = (std::env::var("HPTY_PROBE_FILE"), std::env::var("HPTY_PROBE_OUT")) else { return };
    let socket = format!(r"\\.\pipe\happier-holder-{:024x}", std::process::id() as u128 * 104729);
    let mut holder = Command::new(HOLDER)
        .args(["serve", "--socket", &socket, "--pty", "120x40", "--", "cmd.exe", "/d", "/c", &format!("type {file}")])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut ready = String::new();
    BufReader::new(holder.stdout.take().unwrap()).read_line(&mut ready).unwrap();
    let mut client = Client::connect(&socket);
    let mut seen = Seen::default();
    // The rest of the rendering comes once the pseudoconsole closes, before `z`.
    client.read_until(&mut seen, |seen| seen.closed);
    let bytes: Vec<u8> = seen.output.iter().flat_map(|(_, bytes)| bytes.clone()).collect();
    std::fs::write(out, bytes).unwrap();
    client.send(b'a', &u64::MAX.to_be_bytes());
    exits_within(&mut holder, Duration::from_secs(20));
}
