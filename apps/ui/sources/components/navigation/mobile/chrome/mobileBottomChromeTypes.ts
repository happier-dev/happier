import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';

export type MobileBottomChromeModel =
    | Readonly<{ kind: 'hidden' }>
    | Readonly<{ kind: 'mainAppTabs' }>
    | Readonly<{ kind: 'sessionCockpit'; sessionId: string; surface: SessionMobileSurface; terminalTabAvailable: boolean }>
    | Readonly<{ kind: 'projectCockpit'; workspaceRefId: string; surface: ProjectMobileSurface }>;
