import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type QwenTerminalDisplayProps = ProviderTerminalDisplayProps;

export const QwenTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 Qwen Code',
  accentColor: 'cyan',
  footerName: 'Qwen Code',
});
