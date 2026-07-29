import { showRelayAccessHelp } from './access';
import { showRelayHostHelp } from './host';

export function showRelayHelp(): void {
  // Keep help output concise; detailed relay profile management remains under `happier server ...` for now.
  console.log('happier relay inspect-target [--json]');
  console.log('happier relay use <relay-url | --local [--local-channel stable|preview|dev]> [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  console.log('happier relay add <relay-url | --local [--local-channel stable|preview|dev]> [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  console.log('happier relay set <relay-url | --local [--local-channel stable|preview|dev]> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]');
  showRelayHostHelp();
  showRelayAccessHelp();
  console.log('happier relay start-daemon [--local-channel stable|preview|dev]   # activate local relay profile + start the daemon');
  console.log('happier relay auth [--local-channel stable|preview|dev] [auth flags]  # activate local relay profile + `auth login` against it');
  console.log('');
  console.log('--local picks the local relay matching the current CLI channel; if none exists, the command errors and lists other channels.');
  console.log('--local-channel forces an explicit channel.');
}
