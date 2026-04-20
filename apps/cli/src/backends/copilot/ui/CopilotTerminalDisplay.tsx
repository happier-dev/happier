import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/ui/providers/providerTerminalDisplay';

export type CopilotTerminalDisplayProps = ProviderTerminalDisplayProps;

export const CopilotTerminalDisplay = createProviderTerminalDisplay({
  title: 'Copilot',
  accentColor: 'green',
});
