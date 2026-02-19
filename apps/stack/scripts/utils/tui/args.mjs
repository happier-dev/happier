export function isTuiHelpRequest(argv) {
  if (!Array.isArray(argv)) return false;
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === 'help')) return true;
  return false;
}

export function normalizeTuiForwardedArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return ['dev'];
  return argv;
}
