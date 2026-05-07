export function showRelayHelp(): void {
  // Keep help output concise; detailed relay profile management remains under `happier server ...` for now.
  console.log('happier relay inspect-target [--json]');
  console.log('happier relay use <relay-url | --local [--local-channel stable|preview|dev]> [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  console.log('happier relay add <relay-url | --local [--local-channel stable|preview|dev]> [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  console.log('happier relay set <relay-url | --local [--local-channel stable|preview|dev]> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  console.log('happier relay host <install|status|start|stop|restart|uninstall> [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--env KEY=VALUE]... [--server-binary <path>] [--lan | --expose | --host <ip>] [--yes] [--json]');
  console.log('  --lan           Bind to a LAN/Tailscale IP (auto-detected; prompts if multiple interfaces found)');
  console.log('  --expose        Bind to all interfaces (0.0.0.0) - prints verified reachable addresses when possible');
  console.log('  --host <ip>     Bind to a specific IP address');
  console.log('happier relay start-daemon [--local-channel stable|preview|dev]   # activate local relay profile + start the daemon');
  console.log('happier relay auth [--local-channel stable|preview|dev] [auth flags]  # activate local relay profile + `auth login` against it');
  console.log('');
  console.log('--local picks the local relay matching the current CLI channel; if none exists, the command errors and lists other channels.');
  console.log('--local-channel forces an explicit channel.');
}
