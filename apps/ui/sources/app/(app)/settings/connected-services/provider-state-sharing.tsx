import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { ConnectedServicesProviderStateSharingSettingsView } from '@/components/settings/connectedServices/ConnectedServicesProviderStateSharingSettings';

export default function ConnectedServicesProviderStateSharingRoute() {
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');

    if (!connectedServicesEnabled) {
        return null;
    }

    return <ConnectedServicesProviderStateSharingSettingsView />;
}
