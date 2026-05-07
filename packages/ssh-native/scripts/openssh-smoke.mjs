#!/usr/bin/env node
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const crateRoot = join(repoRoot, 'packages', 'ssh-native', 'rust', 'happier-ssh-native');
const image = process.env.HAPPIER_SSH_NATIVE_OPENSSH_IMAGE || 'lscr.io/linuxserver/openssh-server:latest';
const username = 'happier';
const password = 'happier-password';
const keyPassphrase = 'happier-passphrase';
const containerName = `happier-ssh-native-smoke-${process.pid}`;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env || {}) },
      cwd: options.cwd || repoRoot,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function waitForTcp(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolvePromise) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(1_000);
      socket.once('connect', () => {
        socket.destroy();
        resolvePromise(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolvePromise(false);
      });
      socket.once('error', () => resolvePromise(false));
    });
    if (ok) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`OpenSSH container did not accept TCP connections on ${port}`);
}

async function dockerHostPort() {
  const { stdout } = await run('docker', ['port', containerName, '2222/tcp']);
  const line = stdout.trim().split(/\r?\n/u).find(Boolean) || '';
  const match = /:(\d+)$/u.exec(line);
  if (!match) {
    throw new Error(`Could not resolve Docker SSH port from: ${stdout}`);
  }
  return Number(match[1]);
}

async function writeSmokeCrate(root) {
  const sourceDir = join(root, 'src');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), `
[package]
name = "happier-ssh-native-openssh-smoke"
version = "0.0.0"
edition = "2021"

[dependencies]
happier-ssh-native = { path = ${JSON.stringify(crateRoot)} }
`, 'utf8');
  await writeFile(join(sourceDir, 'main.rs'), String.raw`
use std::env;
use std::io::Read;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use happier_ssh_native::cancellation::cancel_request;
use happier_ssh_native::engine::run_exec_blocking;
use happier_ssh_native::error::NativeSshError;
use happier_ssh_native::host_key::HostKeyPrompter;
use happier_ssh_native::tunnel::{start_loopback_tunnel_blocking, stop_loopback_tunnel};
use happier_ssh_native::types::{
    NativeSshAuthRequest, NativeSshExecRequest, NativeSshHostKeyPrompt,
    NativeSshHostKeyVerification, NativeSshLoopbackTunnelRequest,
};

#[derive(Clone)]
enum PromptMode {
    Accept,
    Reject,
}

#[derive(Clone)]
struct SmokePrompter {
    mode: PromptMode,
    observed_fingerprint: Arc<Mutex<Option<String>>>,
}

impl SmokePrompter {
    fn accept() -> Self {
        Self {
            mode: PromptMode::Accept,
            observed_fingerprint: Arc::new(Mutex::new(None)),
        }
    }

    fn reject() -> Self {
        Self {
            mode: PromptMode::Reject,
            observed_fingerprint: Arc::new(Mutex::new(None)),
        }
    }
}

impl HostKeyPrompter for SmokePrompter {
    fn prompt(&self, prompt: NativeSshHostKeyPrompt) -> NativeSshHostKeyVerification {
        *self.observed_fingerprint.lock().expect("prompt lock") = Some(prompt.fingerprint_sha256.clone());
        match self.mode {
            PromptMode::Accept => NativeSshHostKeyVerification::AcceptOnce {
                fingerprint_sha256: prompt.fingerprint_sha256,
            },
            PromptMode::Reject => NativeSshHostKeyVerification::Reject {
                reason: Some("smoke rejection".to_string()),
            },
        }
    }
}

struct SmokeConfig {
    host: String,
    port: u16,
    username: String,
    password: String,
    private_key_pem: String,
    passphrase_key_pem: String,
    passphrase: String,
}

fn base_request(config: &SmokeConfig, request_id: &str, auth: NativeSshAuthRequest, command: &str) -> NativeSshExecRequest {
    NativeSshExecRequest {
        request_id: request_id.to_string(),
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        command: command.to_string(),
        auth,
        connect_timeout_ms: 15_000,
        auth_timeout_ms: 15_000,
        exec_timeout_ms: 15_000,
        host_key_verification: NativeSshHostKeyVerification::Prompt,
    }
}

fn password_auth(config: &SmokeConfig) -> NativeSshAuthRequest {
    NativeSshAuthRequest {
        username: config.username.clone(),
        password: Some(config.password.clone()),
        private_key_pem: None,
        private_key_passphrase: None,
        keyboard_interactive_answers: vec![],
    }
}

fn private_key_auth(config: &SmokeConfig, passphrase: bool) -> NativeSshAuthRequest {
    NativeSshAuthRequest {
        username: config.username.clone(),
        password: None,
        private_key_pem: Some(if passphrase {
            config.passphrase_key_pem.clone()
        } else {
            config.private_key_pem.clone()
        }),
        private_key_passphrase: if passphrase { Some(config.passphrase.clone()) } else { None },
        keyboard_interactive_answers: vec![],
    }
}

fn expect_error_code(result: Result<happier_ssh_native::types::NativeSshExecResult, NativeSshError>, code: &str) {
    match result {
        Ok(_) => panic!("expected error {code}"),
        Err(error) => assert_eq!(error.code, code),
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let config = SmokeConfig {
        host: args[1].clone(),
        port: args[2].parse().expect("port"),
        username: args[3].clone(),
        password: args[4].clone(),
        private_key_pem: std::fs::read_to_string(&args[5]).expect("private key"),
        passphrase_key_pem: std::fs::read_to_string(&args[6]).expect("passphrase key"),
        passphrase: args[7].clone(),
    };

    let accept_prompter = Arc::new(SmokePrompter::accept());
    let exec_result = run_exec_blocking(
        base_request(
            &config,
            "smoke-password",
            password_auth(&config),
            "printf stdout-ok; printf stderr-ok >&2; exit 7",
        ),
        accept_prompter.clone(),
    ).expect("password exec");
    assert_eq!(exec_result.exit_code, Some(7));
    assert_eq!(exec_result.stdout, "stdout-ok");
    assert_eq!(exec_result.stderr, "stderr-ok");
    assert!(accept_prompter.observed_fingerprint.lock().expect("fingerprint").is_some());

    run_exec_blocking(
        base_request(&config, "smoke-private-key", private_key_auth(&config, false), "true"),
        Arc::new(SmokePrompter::accept()),
    ).expect("private key exec");

    run_exec_blocking(
        base_request(&config, "smoke-passphrase-key", private_key_auth(&config, true), "true"),
        Arc::new(SmokePrompter::accept()),
    ).expect("passphrase private key exec");

    expect_error_code(
        run_exec_blocking(
            base_request(&config, "smoke-host-key-reject", password_auth(&config), "true"),
            Arc::new(SmokePrompter::reject()),
        ),
        "host-key-untrusted",
    );

    let mut mismatch = base_request(&config, "smoke-host-key-mismatch", password_auth(&config), "true");
    mismatch.host_key_verification = NativeSshHostKeyVerification::AcceptOnce {
        fingerprint_sha256: "SHA256:wrong".to_string(),
    };
    expect_error_code(run_exec_blocking(mismatch, Arc::new(SmokePrompter::accept())), "host-key-mismatch");

    let tunnel = start_loopback_tunnel_blocking(NativeSshLoopbackTunnelRequest {
        request_id: "smoke-tunnel".to_string(),
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        auth: password_auth(&config),
        host_key_verification: NativeSshHostKeyVerification::AcceptOnce {
            fingerprint_sha256: accept_prompter
                .observed_fingerprint
                .lock()
                .expect("fingerprint lock")
                .clone()
                .expect("accepted fingerprint"),
        },
        destination_host: "127.0.0.1".to_string(),
        destination_port: 2222,
        requested_local_port: None,
        connect_timeout_ms: 15_000,
        auth_timeout_ms: 15_000,
    }).expect("start tunnel");
    let mut stream = TcpStream::connect(("127.0.0.1", tunnel.local_port)).expect("connect tunnel");
    let mut banner = [0u8; 4];
    stream.read_exact(&mut banner).expect("read ssh banner");
    assert_eq!(&banner, b"SSH-");
    stop_loopback_tunnel(&tunnel.native_tunnel_id);

    let cancel_request_id = "smoke-cancel-exec".to_string();
    let cancel_config = SmokeConfig {
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        password: config.password.clone(),
        private_key_pem: config.private_key_pem.clone(),
        passphrase_key_pem: config.passphrase_key_pem.clone(),
        passphrase: config.passphrase.clone(),
    };
    let handle = thread::spawn(move || {
        run_exec_blocking(
            base_request(&cancel_config, &cancel_request_id, password_auth(&cancel_config), "sleep 30"),
            Arc::new(SmokePrompter::accept()),
        )
    });
    thread::sleep(Duration::from_millis(250));
    cancel_request("smoke-cancel-exec");
    match handle.join().expect("cancel thread") {
        Ok(_) => panic!("expected cancellation"),
        Err(error) => assert_eq!(error.code, "cancellation"),
    }

    let connect_cancel_id = "smoke-cancel-connect";
    let mut connect_cancel = base_request(&config, connect_cancel_id, password_auth(&config), "true");
    connect_cancel.host = "10.255.255.1".to_string();
    connect_cancel.connect_timeout_ms = 30_000;
    let handle = thread::spawn(move || {
        run_exec_blocking(connect_cancel, Arc::new(SmokePrompter::accept()))
    });
    thread::sleep(Duration::from_millis(100));
    cancel_request(connect_cancel_id);
    match handle.join().expect("connect cancel thread") {
        Ok(_) => panic!("expected connect cancellation"),
        Err(error) => assert_eq!(error.code, "cancellation"),
    }

    println!("phase0 openssh smoke passed: password auth, private key auth, passphrase key auth, host-key accept/reject/mismatch, bounded exec stdout/stderr/exit, direct TCP loopback tunnel, cancellation while executing and connecting");
}
`, 'utf8');
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-ssh-native-openssh-smoke-'));
  try {
    const keyPath = join(scratch, 'id_ed25519');
    const passphraseKeyPath = join(scratch, 'id_ed25519_passphrase');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'happier-smoke']);
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', keyPassphrase, '-f', passphraseKeyPath, '-C', 'happier-smoke-passphrase']);
    const authorizedKeys = [
      await readFile(`${keyPath}.pub`, 'utf8'),
      await readFile(`${passphraseKeyPath}.pub`, 'utf8'),
    ].join('');
    const configDir = join(scratch, 'config');
    await mkdir(join(configDir, '.ssh'), { recursive: true });
    await writeFile(join(configDir, '.ssh', 'authorized_keys'), authorizedKeys, 'utf8');

    await run('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-p',
      '127.0.0.1::2222',
      '-e',
      'PUID=1000',
      '-e',
      'PGID=1000',
      '-e',
      'TZ=Etc/UTC',
      '-e',
      `USER_NAME=${username}`,
      '-e',
      `USER_PASSWORD=${password}`,
      '-e',
      'PASSWORD_ACCESS=true',
      '-e',
      'SUDO_ACCESS=false',
      '-e',
      `PUBLIC_KEY=${authorizedKeys}`,
      '-v',
      `${configDir}:/config`,
      image,
    ]);
    await run('docker', [
      'exec',
      containerName,
      'sh',
      '-lc',
      [
        "sed -i 's/^AllowTcpForwarding .*/AllowTcpForwarding yes/' /etc/ssh/sshd_config /config/sshd/sshd_config",
        'pkill -HUP sshd || true',
      ].join(' && '),
    ]);
    const port = await dockerHostPort();
    await waitForTcp(port);

    const smokeCrate = join(scratch, 'smoke-crate');
    await writeSmokeCrate(smokeCrate);
    await run('cargo', [
      'run',
      '--quiet',
      '--manifest-path',
      join(smokeCrate, 'Cargo.toml'),
      '--',
      '127.0.0.1',
      String(port),
      username,
      password,
      keyPath,
      passphraseKeyPath,
      keyPassphrase,
    ], {
      stdio: 'inherit',
    });
  } finally {
    await run('docker', ['rm', '-f', containerName]).catch(() => {});
    if (process.env.HAPPIER_KEEP_SSH_NATIVE_SMOKE_ARTIFACTS !== '1') {
      await rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`kept smoke artifacts at ${scratch}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
