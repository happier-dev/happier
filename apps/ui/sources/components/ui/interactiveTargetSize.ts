import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

/**
 * Core's compatibility name over the shared platform-policy owner. App code
 * still supplies its local `Platform.OS` fact; shared presentation reads the
 * equivalent fact from its environment provider.
 */
export function resolveMinimumInteractiveTargetSize(platform: string): 44 | 48 {
    return resolveHappierMinimumInteractiveTargetSize(platform);
}
