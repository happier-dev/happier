import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/ui/providers/providerTerminalDisplay';

export type QwenTerminalDisplayProps = ProviderTerminalDisplayProps;

export const QwenTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 Qwen Code',
  accentColor: 'cyan',
  footerName: 'Qwen Code',
});
