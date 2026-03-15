import qrcode from 'qrcode-terminal';

/**
 * Display a QR code in the terminal for the given URL
 */
export function displayQRCode(url: string, opts: Readonly<{ title?: string | null }> = {}): void {
  console.log('='.repeat(80));
  const title = typeof opts.title === 'string' ? opts.title.trim() : '';
  if (title) {
    console.log(title);
  }
  console.log('='.repeat(80));
  qrcode.generate(url, { small: true }, (qr) => {
    for (let l of qr.split('\n')) {
      console.log(' '.repeat(10) + l);
    }
  });
  console.log('='.repeat(80));
} 
