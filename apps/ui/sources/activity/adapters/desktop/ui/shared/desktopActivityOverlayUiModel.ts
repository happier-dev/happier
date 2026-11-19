import type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel,
} from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopActivityOverlayActionDescriptor } from '@/activity/adapters/desktop/presentation/model/desktopActivityOverlayModelTypes';

export type DesktopActivityOverlayActionOutcome = Readonly<{ ok: true } | { ok: false; errorCode?: string }>;
export type DesktopActivityOverlayActionHandler = (action: DesktopActivityOverlayActionDescriptor) =>
    DesktopActivityOverlayActionOutcome | Promise<DesktopActivityOverlayActionOutcome>;

export type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel as DesktopActivityOverlayUiModel,
};

// The island renders the model's own action descriptors; one type, owned by the model.
export type {
    DesktopActivityOverlayActionDescriptor,
    DesktopActivityOverlayActionTone,
    DesktopActivityOverlaySessionRowModel,
} from '@/activity/adapters/desktop/presentation/model/desktopActivityOverlayModelTypes';
