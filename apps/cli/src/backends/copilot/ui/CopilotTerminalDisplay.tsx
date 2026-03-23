import { createProviderTerminalDisplay, type ProviderTerminalDisplayProps } from '@/backends/shared/createProviderTerminalDisplay';

export type CopilotTerminalDisplayProps = ProviderTerminalDisplayProps;

export const CopilotTerminalDisplay = createProviderTerminalDisplay({
  title: 'Copilot',
  accentColor: 'green',
});
