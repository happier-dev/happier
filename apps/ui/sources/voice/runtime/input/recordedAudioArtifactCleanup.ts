import { Platform } from 'react-native';

export type RecordedAudioArtifactCleanupResult =
    | Readonly<{ kind: 'no_artifact' }>
    | Readonly<{ kind: 'cleaned' }>
    | Readonly<{ kind: 'failed'; error: unknown }>;

export type RecordedAudioArtifactCleanup = Readonly<{
    admit: (uri: string | null | undefined) => void;
    cleanup: () => Promise<RecordedAudioArtifactCleanupResult>;
}>;

/**
 * Owns one temporary recording for one capture attempt. A terminal path can
 * start cleanup before its recorder finishes; a later admitted URI is still
 * consumed by the next cleanup call. Successful cleanup is idempotent, while
 * a failed deletion deliberately retains the artifact and its failure result.
 */
export function createRecordedAudioArtifactCleanup(
    deleteArtifact: (uri: string) => void | Promise<void>,
): RecordedAudioArtifactCleanup {
    let uri: string | null = null;
    let cleanupResult: RecordedAudioArtifactCleanupResult | null = null;
    let cleanupPromise: Promise<RecordedAudioArtifactCleanupResult> | null = null;

    return {
        admit: (nextUri) => {
            if (!nextUri || uri !== null || cleanupResult !== null) return;
            uri = nextUri;
        },
        cleanup: () => {
            if (cleanupResult) return Promise.resolve(cleanupResult);
            if (!uri) return Promise.resolve({ kind: 'no_artifact' });
            const artifactUri = uri;
            cleanupPromise ??= Promise.resolve()
                .then(async () => {
                    await deleteArtifact(artifactUri);
                    if (uri === artifactUri) {
                        uri = null;
                    }
                    cleanupResult = { kind: 'cleaned' };
                    return cleanupResult;
                })
                .catch((error): RecordedAudioArtifactCleanupResult => {
                    cleanupResult = { kind: 'failed', error };
                    return cleanupResult;
                });
            return cleanupPromise;
        },
    };
}

export async function deleteRecordedAudioArtifact(uri: string): Promise<void> {
    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
        URL.revokeObjectURL(uri);
        return;
    }
    const { File } = await import('expo-file-system');
    const file = new File(uri);
    if (file.exists !== false) {
        await file.delete();
    }
}
