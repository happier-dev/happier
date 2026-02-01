import qrcodeTerminal from 'qrcode-terminal';

export async function renderQrAscii(text, { small = true } = {}) {
  const qrText = String(text ?? '');
  if (!qrText) return { ok: false, lines: [], error: 'empty QR payload' };
  try {
    const out = await new Promise((resolvePromise) => {
      qrcodeTerminal.generate(qrText, { small: Boolean(small) }, (qr) => resolvePromise(String(qr ?? '')));
    });
    // Important: keep whitespace; scanners rely on quiet-zone padding.
    const lines = String(out ?? '').replace(/\r/g, '').split('\n');
    return { ok: true, lines, error: null };
  } catch (e) {
    return { ok: false, lines: [], error: e instanceof Error ? e.message : String(e) };
  }
}

