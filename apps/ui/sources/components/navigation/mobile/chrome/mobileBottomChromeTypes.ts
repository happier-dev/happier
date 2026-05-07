import type { TabType } from '@/components/ui/navigation/tabTypes';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';

export type MobileBottomChromeModel =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'mainAppTabs'; activeTab: TabType }>
    | Readonly<{
        kind: 'sessionCockpit';
        sessionId: string;
        surface: SessionMobileSurface;
        terminalTabAvailable: boolean;
    }>;
