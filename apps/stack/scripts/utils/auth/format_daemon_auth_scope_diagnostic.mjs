function safeInlineValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // Avoid newlines/log injection and keep this stable for grepping.
  return raw.replace(/\s+/g, ' ');
}

export function formatDaemonAuthScopeDiagnostic({
  activeServerId,
  activeCredentialPath,
  tokenSub,
  tokenSubBeforeRepair,
  repairedFromPath,
  repairedFromSub,
}) {
  const serverId = safeInlineValue(activeServerId) ?? 'unknown';
  const activePath = safeInlineValue(activeCredentialPath) ?? 'unknown';
  const sub = safeInlineValue(tokenSub);
  const subBefore = safeInlineValue(tokenSubBeforeRepair);
  const repairedFrom = safeInlineValue(repairedFromPath);
  const repairedSub = safeInlineValue(repairedFromSub);

  const parts = [
    '[local] daemon auth scope:',
    `activeServerId=${serverId}`,
    `activeCredential=${activePath}`,
  ];
  if (sub) parts.push(`tokenSub=${sub}`);
  if (subBefore) parts.push(`tokenSubBeforeRepair=${subBefore}`);
  if (repairedFrom) parts.push(`repairedFrom=${repairedFrom}`);
  if (repairedSub) parts.push(`repairedFromSub=${repairedSub}`);
  return parts.join(' ');
}

export function formatDaemonCredentialsTokenSubChangedWarning({
  tokenSubBeforeRepair,
  tokenSub,
} = {}) {
  const before = safeInlineValue(tokenSubBeforeRepair);
  const after = safeInlineValue(tokenSub);
  if (!before || !after) return null;
  return `[local] daemon credentials tokenSub changed: ${before} -> ${after}`;
}
