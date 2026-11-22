import { retryableLazy } from '@/components/ui/performance/retryableLazy';

/** The entry for the editor inside hosts that also mount with a closed composer. */
export const NewSessionScreenEntry = retryableLazy(async () => ({
    default: (await import('./NewSessionScreen')).NewSessionScreen,
}));
