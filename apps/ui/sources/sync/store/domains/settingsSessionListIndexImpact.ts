import type { Settings } from '../../domains/settings/settings';

export function resolveSessionListIndexSettingsImpact(
    previousSettings: Settings,
    nextSettings: Settings,
): boolean {
    return nextSettings.sessionListLayoutV1 !== previousSettings.sessionListLayoutV1;
}
