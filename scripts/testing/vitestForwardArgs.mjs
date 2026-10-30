// Runner-only options must not reach Vitest or its command classifier.
export function resolveVitestForwardArgs(argv) {
  const forwarded = [];
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') { index += 1; continue; }
    if (arg.startsWith('--config=') || arg === '--unit-checks' || arg === '--unit-checks-only') continue;
    forwarded.push(arg);
  }
  if (forwarded[0] === '--') forwarded.shift();
  return forwarded;
}
