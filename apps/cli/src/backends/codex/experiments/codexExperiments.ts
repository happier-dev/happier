export function isExperimentalCodexAcpEnabled(processEnv: NodeJS.ProcessEnv = process.env): boolean {
  const raw = processEnv.HAPPIER_EXPERIMENTAL_CODEX_ACP;
  return typeof raw === 'string' && ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
}
