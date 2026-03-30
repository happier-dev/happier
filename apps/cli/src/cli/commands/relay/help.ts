export function showRelayHelp(): void {
  // Keep help output concise; detailed relay profile management remains under `happier server ...` for now.
  console.log('happier relay inspect-target [--json]');
  console.log('happier relay upsert-by-url <relay-url> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
}
