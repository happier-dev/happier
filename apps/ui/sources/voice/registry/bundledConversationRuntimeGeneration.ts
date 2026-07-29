type GenerationLease = Readonly<{
  runIfCurrent<T>(callback: () => T): T | undefined;
  isCurrent(): boolean;
  canCleanup(): boolean;
  revoke(): void;
}>;

let nextGeneration = 0;
let activeGeneration: number | null = null;
let generationRevision = 0;
const generationListeners = new Set<() => void>();

function publishGenerationChange(): void {
  generationRevision += 1;
  for (const listener of generationListeners) listener();
}

export function getBundledConversationRuntimeGenerationRevision(): number {
  return generationRevision;
}

export function subscribeBundledConversationRuntimeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

/** Synchronous ownership lease protecting singleton voice state from late async teardown. */
export function acquireBundledConversationRuntimeGeneration(): GenerationLease {
  const generation = ++nextGeneration;
  let revoked = false;
  activeGeneration = generation;
  publishGenerationChange();
  return Object.freeze({
    runIfCurrent<T>(callback: () => T): T | undefined {
      return !revoked && activeGeneration === generation ? callback() : undefined;
    },
    isCurrent: () => !revoked && activeGeneration === generation,
    canCleanup: () => activeGeneration === null || activeGeneration === generation,
    revoke() {
      if (revoked) return;
      revoked = true;
      if (activeGeneration === generation) {
        activeGeneration = null;
        publishGenerationChange();
      }
    },
  });
}

export function resetBundledConversationRuntimeGenerationForTests(): void {
  nextGeneration = 0;
  activeGeneration = null;
  publishGenerationChange();
}
