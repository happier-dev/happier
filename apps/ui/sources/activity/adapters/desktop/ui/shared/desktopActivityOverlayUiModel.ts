import type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel,
} from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopActivityOverlayActionDescriptor } from '@/activity/adapters/desktop/presentation/model/desktopActivityOverlayModelTypes';

/** True means the addressed action completed successfully. */
export type DesktopActivityOverlayActionHandler = (action: DesktopActivityOverlayActionDescriptor) => boolean | Promise<boolean>;

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
