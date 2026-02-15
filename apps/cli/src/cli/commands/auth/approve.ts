import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

export async function handleAuthApprove(argsRaw: string[]): Promise<void> {
  const args = await applyServerSelectionFromArgs(argsRaw);

  const json = args.includes('--json');
  if (!json) {
    console.error('Missing required flag: --json');
    process.exit(2);
  }

  const keyIndex = args.findIndex((a) => a === '--public-key');
  const publicKeyRaw = keyIndex >= 0 ? (args[keyIndex + 1] ?? '') : '';
  if (!publicKeyRaw || String(publicKeyRaw).startsWith('--')) {
    console.error('Missing required flag: --public-key <base64>');
    process.exit(2);
  }
  try {
    await approveTerminalAuthRequest({ publicKey: String(publicKeyRaw) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to approve auth request.');
    process.exit(1);
  }

  console.log(JSON.stringify({ success: true }));
}
