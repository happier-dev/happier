export const ATTACH_USAGE = 'Usage: happier attach <sessionId>';

export function printAttachHelp(): void {
  console.log('happier attach');
  console.log('happier attach <session-id-or-prefix>');
  console.log('');
  console.log('Attaches a terminal to a running session on this computer.');
  console.log('');
  console.log('For a session on the built-in terminal host, press Ctrl-] to detach;');
  console.log('the session keeps running.');
}
