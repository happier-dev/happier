import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type OpenCodeTerminalDisplayProps = ProviderTerminalDisplayProps;

export const OpenCodeTerminalDisplay = createProviderTerminalDisplay({
  title: '🤖 OpenCode',
  accentColor: 'green',
  footerName: 'OpenCode',
});
