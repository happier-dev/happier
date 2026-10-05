import { HomeConsoleLayout } from '@/components/settings/home/governance/HomeConsoleLayout';
import { createSettingsLayoutRoute } from '@/components/settings/navigation/createSettingsLayoutRoute';

export default createSettingsLayoutRoute(HomeConsoleLayout, 'home/[serverId]');
