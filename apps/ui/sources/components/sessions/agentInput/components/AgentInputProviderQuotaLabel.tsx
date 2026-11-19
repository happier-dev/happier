import { useLiveQuotaMeterLabel } from '@/components/settings/connectedServices/useLiveQuotaMeterLabel';

type Props = Omit<Parameters<typeof useLiveQuotaMeterLabel>[0], 'surface'>;

export function AgentInputProviderQuotaLabel(props: Props) {
    return useLiveQuotaMeterLabel({ ...props, surface: 'composer' });
}
