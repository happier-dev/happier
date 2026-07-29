import type {
    VirtualizedListBackend,
    VirtualizedListBackendPreference,
} from './virtualizedListTypes';

export type ResolveVirtualizedListBackendInput = Readonly<{
    preference?: VirtualizedListBackendPreference;
    platformOS: string;
}>;

/**
 * Single owner of "which list runtime does this surface get". Product call
 * sites must never branch on `Platform.OS`, FlashList, or Legend directly — they
 * express a {@link VirtualizedListBackendPreference} and this function decides.
 *
 * Dev's migration end state is Legend on every platform. Explicit `flat`
 * remains the bounded escape hatch for consumers with a proven platform
 * requirement; Flash is deliberately not exposed as a generic-list backend.
 */
export function resolveVirtualizedListBackend(
    input: ResolveVirtualizedListBackendInput,
): VirtualizedListBackend {
    const preference = input.preference ?? 'auto';
    if (preference !== 'auto') {
        return preference;
    }
    return 'legend';
}
