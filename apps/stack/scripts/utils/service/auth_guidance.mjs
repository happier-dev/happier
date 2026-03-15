function isLocalishHostname(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

export function isLocalishUrl(urlRaw) {
  const raw = String(urlRaw ?? '').trim();
  if (!raw) return true;
  try {
    const url = new URL(raw);
    return isLocalishHostname(url.hostname);
  } catch {
    // If it's not parseable, treat as "not safe for mobile" (fail-closed).
    return true;
  }
}

function baseAuthLoginCmd(stackName) {
  const name = String(stackName ?? '').trim() || 'main';
  return name === 'main' ? 'hstack auth login' : `hstack stack auth ${name} login`;
}

export function buildServiceAuthGuidance({
  stackName,
  publicServerUrl,
  tailscaleServeEnabled = false,
  publicServerUrlSource = '',
} = {}) {
  const name = String(stackName ?? '').trim() || 'main';
  const url = String(publicServerUrl ?? '').trim();
  const source = String(publicServerUrlSource ?? '').trim().toLowerCase();
  const isTailscaleUrl = source.startsWith('tailscale') || url.includes('.ts.net');

  const headlessCmd = `${baseAuthLoginCmd(name)} --method=mobile --no-open`;
  const laptopCmd = `${baseAuthLoginCmd(name)} --method=web --webapp=hosted`;

  const warnings = [];
  const mobileNeedsPublicUrl = isLocalishUrl(url);
  const tailscaleEnabled = Boolean(tailscaleServeEnabled) || isTailscaleUrl;
  if (mobileNeedsPublicUrl && !tailscaleEnabled) {
    warnings.push(
      `[service] Mobile authentication will not work yet because this stack has no public server URL.\n` +
        `[service] Current public URL: ${url || '(empty)'}\n` +
        `[service] Fix: set HAPPIER_STACK_SERVER_URL to an https:// URL (Tailscale Serve or a reverse proxy).`
    );
  }

  return {
    headlessCmd,
    laptopCmd,
    warnings,
  };
}
