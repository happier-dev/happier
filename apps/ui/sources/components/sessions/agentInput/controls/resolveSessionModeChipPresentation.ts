import type { IconName } from '@/components/ui/icons/Icon';
type SessionModeOptionLike = Readonly<{
    id: string;
    name: string;
}>;

type SessionModeChipControlLike = Readonly<{
    options: ReadonlyArray<SessionModeOptionLike>;
    selectedId: string;
    label: string;
}>;

export type SessionModeChipPresentation =
    Readonly<{
    iconName: IconName;
    label: string;
}>;

const PLAN_MODE_ALIASES = new Set(['plan']);
const BUILD_MODE_ALIASES = new Set(['build']);

function normalizeModeToken(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

export function resolveSessionModeChipPresentation(
    control: SessionModeChipControlLike,
): SessionModeChipPresentation {
    const selectedOption = control.options.find((option) => option.id === control.selectedId) ?? null;
    const tokens = [
        normalizeModeToken(control.selectedId),
        normalizeModeToken(control.label),
        normalizeModeToken(selectedOption?.name),
    ].filter((value): value is string => value !== null);

    const isPlan = tokens.some((token) => PLAN_MODE_ALIASES.has(token));
    const isBuild = tokens.some((token) => BUILD_MODE_ALIASES.has(token));

    if (isBuild && !isPlan) {
        return {
            iconName: 'rocket-launch',
            label: control.label,
        };
    }

    return {
        iconName: 'list',
        label: control.label,
    };
}
