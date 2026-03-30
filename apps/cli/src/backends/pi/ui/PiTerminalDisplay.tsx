import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type PiTerminalDisplayProps = ProviderTerminalDisplayProps;

export const PiTerminalDisplay = createProviderTerminalDisplay({
  title: 'Pi',
  accentColor: 'cyan',
});
