import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/ui/providers/providerTerminalDisplay';

export type PiTerminalDisplayProps = ProviderTerminalDisplayProps;

export const PiTerminalDisplay = createProviderTerminalDisplay({
  title: 'Pi',
  accentColor: 'cyan',
});
