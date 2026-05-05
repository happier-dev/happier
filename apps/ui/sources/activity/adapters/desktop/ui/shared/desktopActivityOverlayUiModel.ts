import type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel,
} from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';

export type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel as DesktopActivityOverlayUiModel,
};

export type DesktopActivityOverlayActionTone = 'primary' | 'secondary' | 'danger';

export type DesktopActivityOverlayActionDescriptor = Readonly<{
    id: string;
    label: string;
    actionIdentifier: string;
    accessibilityLabel?: string | null;
    data?: Readonly<Record<string, unknown>>;
    tone?: DesktopActivityOverlayActionTone;
    inputKind?: 'inline_text';
}>;
