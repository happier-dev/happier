import { VoiceConversationsSettingsScreen } from '@/voice/settings/screens/VoiceConversationsSettingsScreen';
import { SettingsPageFeatureGate } from '@/components/settings/catalog/runtime/SettingsPageFeatureGate';
export function WorkspaceRouteBody() {
    return <SettingsPageFeatureGate pageId="voiceConversations"><VoiceConversationsSettingsScreen /></SettingsPageFeatureGate>;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
