export const TOOLS_USAGE = `Usage: happier tools <list|search|describe|call|run> ...

  search [query]               Find Session tools
  list [--query <query>]       List tools or search the Session catalog
  describe --source <source> --tool <tool>
  call --source <source> --tool <tool> --args-json '<json>'
  run <file|-> | --code '<javascript>' [--raw]

Use --session-id <id> to select a Session when running from your own terminal.`;
