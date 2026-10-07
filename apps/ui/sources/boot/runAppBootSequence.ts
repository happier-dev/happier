import type { AuthCredentials } from '@/auth/storage/tokenStorage';

export type AppBootReadyState = Readonly<{
    credentials: AuthCredentials | null;
}>;

export type AppBootSequence = Readonly<{
    context?: 'app' | 'embed';
    loadFonts: () => Promise<unknown>;
    sodiumReady: PromiseLike<unknown>;
    resolveCredentials: () => Promise<AuthCredentials | null>;
    /**
     * Retires plaintext warm-cache bytes older builds left behind and resolves the cache's at-rest
     * key in the background. Sync restore reads any cache already available synchronously;
     * unresolved preparation takes the cache owner's cold path and never gates rendering.
     */
    prepareWarmCache: () => Promise<unknown>;
    /** Authoritative user input must be loaded before any synchronous reader can mount. */
    prepareSessionDrafts: () => Promise<void>;
    /**
     * `null` when this host must not restore sync (the desktop activity overlay window renders
     * against the already-running main window's sync).
     *
     * Contract: the call publishes the local restore phase (warm cache -> store) synchronously
     * before it returns; the returned promise is the transport phase (carrier, socket, bootstrap),
     * which first paint never waits for.
     */
    restoreSync: ((credentials: AuthCredentials) => Promise<unknown>) | null;
    onReady: (state: AppBootReadyState) => void;
}>;

type CredentialOutcome = Readonly<{ credentials: AuthCredentials | null }>;

function start<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return operation();
    } catch (error) {
        return Promise.reject(error);
    }
}

/**
 * Starts restore: its local phase has run when this returns, its transport phase continues in the
 * background. A transport failure keeps the app usable; the connection owner's retry path recovers.
 */
function startSyncRestore(sequence: AppBootSequence, credentials: AuthCredentials): void {
    if (!sequence.restoreSync) return;
    start(() => sequence.restoreSync!(credentials)).catch((error: unknown) => {
        console.error('Failed to restore sync during init, continuing startup:', error);
    });
}

/**
 * Owns everything that gates the app's first paint.
 *
 * Fonts, the libsodium runtime and the credential read start together. Optional fonts never gate
 * first paint: the platform fallback is usable while registration continues. Account authority
 * comes from the credential read, never from how long the read takes.
 *
 * Restore's local phase publishes whatever warm cache is already available synchronously. An
 * unresolved cache key means a cold restore; its eventual completion enables future cache use,
 * never another restore of this boot's Account. The transport phase (an Iroh carrier, the socket,
 * bootstrap) is also background work: an unreachable Home must not hold the splash. The connection
 * owner serializes any switch or retry behind that phase.
 */
export async function runAppBootSequence(sequence: AppBootSequence): Promise<void> {
    // Independent preparation starts together.
    void start(sequence.loadFonts).then(
        () => {},
        (error: unknown) => {
            // Font loading failures should not brick startup.
            console.info('Font loading unavailable, using platform fallback:', error);
        },
    );
    if (sequence.context === 'embed') {
        // The bridge is the credential authority in this realm. No persisted app state belongs
        // to the frame, including drafts or a warm cache from another signed-in Account.
        await Promise.resolve(sequence.sodiumReady);
        sequence.onReady({ credentials: null });
        return;
    }
    const credentialsResolved: Promise<CredentialOutcome> = start(sequence.resolveCredentials).then(
        (credentials) => ({ credentials }),
        (error: unknown) => {
            console.error('Failed to resolve credentials during init, continuing startup:', error);
            // A rejected read is a definitive answer for this boot.
            return { credentials: null };
        },
    );
    void start(sequence.prepareWarmCache).then(
        () => {},
        (error: unknown) => {
            // No key means a cold boot, which the cache is designed to survive.
            console.error('Failed to prepare the warm cache key during init, continuing startup:', error);
        },
    );
    const sodiumReady = Promise.resolve(sequence.sodiumReady);

    // Unlike the disposable warm cache, drafts cannot degrade to an empty snapshot on failure.
    // Attach this await immediately so a rejected storage open reaches the boot recovery owner.
    await start(sequence.prepareSessionDrafts);

    let initialCredentials: AuthCredentials | null = null;
    try {
        initialCredentials = (await credentialsResolved).credentials;
        await sodiumReady;
    } catch (error) {
        console.error('Error initializing:', error);
    }

    if (initialCredentials) {
        startSyncRestore(sequence, initialCredentials);
    }
    sequence.onReady({ credentials: initialCredentials });
}
