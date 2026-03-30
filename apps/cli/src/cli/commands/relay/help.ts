export function showRelayHelp(): void {
  // Keep help output concise; detailed relay profile management remains under `happier server ...` for now.
  console.log('happier relay inspect-target [--json]');
  console.log('happier relay set <relay-url> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  console.log('happier relay host <install|status|start|stop|restart> [--ssh <user@host>] [--mode user|system] [--channel stable|preview|dev] [--json]');
}
