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
  repairedFromPath,
}) {
  const serverId = safeInlineValue(activeServerId) ?? 'unknown';
  const activePath = safeInlineValue(activeCredentialPath) ?? 'unknown';
  const sub = safeInlineValue(tokenSub);
  const repairedFrom = safeInlineValue(repairedFromPath);

  const parts = [
    '[local] daemon auth scope:',
    `activeServerId=${serverId}`,
    `activeCredential=${activePath}`,
  ];
  if (sub) parts.push(`tokenSub=${sub}`);
  if (repairedFrom) parts.push(`repairedFrom=${repairedFrom}`);
  return parts.join(' ');
}

