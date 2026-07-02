import { createJsonlFollowController } from './createJsonlFollowController';
import type { JsonlFollowController } from './createJsonlFollowController';
import type {
  FileBackedTranscriptPageResult,
  FileBackedTranscriptReadAfterResult,
  FileBackedTranscriptSessionStore,
  FileBackedTranscriptSessionStoreKey,
  FileBackedTranscriptSessionStoreLifecycleState,
  FileBackedTranscriptSubscriptionListener,
} from '../store';

type ProjectedJsonlResolvedFile = Readonly<{
  filePath: string;
}>;

type ProjectedJsonlSessionStoreOperations<TItem, TActivity, TPageParams, TReadAfterParams, TPreview> = Readonly<{
  resolveFile: (key: FileBackedTranscriptSessionStoreKey) => Promise<ProjectedJsonlResolvedFile | null>;
  pageOlder: (
    key: FileBackedTranscriptSessionStoreKey,
    params: TPageParams | undefined,
  ) => Promise<FileBackedTranscriptPageResult<TItem>>;
  readAfter: (
    key: FileBackedTranscriptSessionStoreKey,
    params: TReadAfterParams | undefined,
    currentTailCursor: string | null,
  ) => Promise<FileBackedTranscriptReadAfterResult<TItem>>;
  getTitle?: (key: FileBackedTranscriptSessionStoreKey) => Promise<string | null>;
  getWorkingDirectory?: (key: FileBackedTranscriptSessionStoreKey) => Promise<string | null>;
  getActivity?: (key: FileBackedTranscriptSessionStoreKey) => Promise<TActivity | null>;
  getPreview?: (key: FileBackedTranscriptSessionStoreKey) => Promise<TPreview>;
  followPollIntervalMs?: number;
}>;

class ProjectedJsonlSessionStore<TItem, TActivity, TPageParams, TReadAfterParams, TPreview>
  implements FileBackedTranscriptSessionStore<TItem, TActivity, TPreview>
{
  private lifecycleState: FileBackedTranscriptSessionStoreLifecycleState = 'warm_detached';
  private titlePromise: Promise<string | null> | null = null;
  private workingDirectoryPromise: Promise<string | null> | null = null;
  private previewPromise: Promise<TPreview> | null = null;
  private tailCursor: string | null = null;
  private readonly subscriptionListeners = new Set<FileBackedTranscriptSubscriptionListener<TItem>>();
  private subscriptionController: JsonlFollowController | null = null;
  private subscriptionControllerStartupPromise: Promise<void> | null = null;
  private subscriptionControllerStartupGeneration = 0;
  private subscriptionCursor: string | null = null;
  private subscriptionDrainPromise: Promise<void> | null = null;
  private subscriptionDrainQueued = false;
  private resolvedFilePromise: Promise<ProjectedJsonlResolvedFile | null> | null = null;

  constructor(
    private readonly key: FileBackedTranscriptSessionStoreKey,
    private readonly operations: ProjectedJsonlSessionStoreOperations<TItem, TActivity, TPageParams, TReadAfterParams, TPreview>,
  ) {}

  async warm(): Promise<void> {
    return;
  }

  async dispose(): Promise<void> {
    this.lifecycleState = 'disposed';
    await this.stopSubscriptionFollower();
  }

  async setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> {
    this.lifecycleState = state;
    if (state === 'hot_attached') {
      await this.ensureSubscriptionFollower();
      return;
    }
    if (this.subscriptionListeners.size === 0) {
      await this.stopSubscriptionFollower();
    }
  }

  async pageOlder(params?: TPageParams): Promise<FileBackedTranscriptPageResult<TItem>> {
    const page = await this.operations.pageOlder(this.key, params);
    this.tailCursor = page.tailCursor ?? this.tailCursor;
    return {
      ...page,
      nextCursor: page.nextCursor ?? null,
      tailCursor: page.tailCursor ?? null,
      truncated: page.truncated === true,
    };
  }

  async readAfter(params?: TReadAfterParams): Promise<FileBackedTranscriptReadAfterResult<TItem>> {
    const read = await this.operations.readAfter(this.key, params, this.tailCursor);
    this.tailCursor = read.nextCursor ?? this.tailCursor;
    return {
      ...read,
      nextCursor: read.nextCursor ?? null,
      truncated: read.truncated === true,
    };
  }

  getTailCursor(): string | null {
    return this.tailCursor;
  }

  subscribe(listener?: FileBackedTranscriptSubscriptionListener<TItem>): () => void {
    if (!listener) {
      return () => {};
    }

    this.subscriptionListeners.add(listener);
    void this.ensureSubscriptionFollower();

    return () => {
      this.subscriptionListeners.delete(listener);
      if (this.subscriptionListeners.size === 0 && this.lifecycleState !== 'hot_attached') {
        void this.stopSubscriptionFollower();
      }
    };
  }

  async getTitle(): Promise<string | null> {
    if (!this.operations.getTitle) return null;
    if (!this.titlePromise) {
      this.titlePromise = this.operations.getTitle(this.key);
    }
    return this.titlePromise;
  }

  async getWorkingDirectory(): Promise<string | null> {
    if (!this.operations.getWorkingDirectory) return null;
    if (!this.workingDirectoryPromise) {
      this.workingDirectoryPromise = this.operations.getWorkingDirectory(this.key);
    }
    return this.workingDirectoryPromise;
  }

  async getActivity(): Promise<TActivity | null> {
    return this.operations.getActivity ? await this.operations.getActivity(this.key) : null;
  }

  async getPreview(): Promise<TPreview> {
    if (this.operations.getPreview) {
      if (!this.previewPromise) {
        this.previewPromise = this.operations.getPreview(this.key);
      }
      return await this.previewPromise;
    }
    return await this.getTitle() as TPreview;
  }

  private async resolveFile(): Promise<ProjectedJsonlResolvedFile | null> {
    if (!this.resolvedFilePromise) {
      let resolvedFilePromise: Promise<ProjectedJsonlResolvedFile | null>;
      resolvedFilePromise = this.operations.resolveFile(this.key)
        .then((resolved) => {
          if (!resolved?.filePath && this.resolvedFilePromise === resolvedFilePromise) {
            this.resolvedFilePromise = null;
          }
          return resolved;
        })
        .catch((error) => {
          if (this.resolvedFilePromise === resolvedFilePromise) {
            this.resolvedFilePromise = null;
          }
          throw error;
        });
      this.resolvedFilePromise = resolvedFilePromise;
    }
    return this.resolvedFilePromise;
  }

  private async ensureSubscriptionFollower(): Promise<void> {
    if (this.subscriptionController || this.lifecycleState === 'disposed' || !this.shouldKeepSubscriptionFollower()) return;
    if (this.subscriptionControllerStartupPromise) {
      await this.subscriptionControllerStartupPromise;
      return;
    }

    const startupGeneration = ++this.subscriptionControllerStartupGeneration;
    const startupPromise = (async () => {
      const resolved = await this.resolveFile();
      if (this.isSubscriptionFollowerStartupStale(startupGeneration) || !resolved?.filePath) return;

      let controller: JsonlFollowController | null = null;
      try {
        controller = createJsonlFollowController({
          filePath: resolved.filePath,
          policy: this.operations.followPollIntervalMs
            ? { activeBurstPollIntervalMs: this.operations.followPollIntervalMs }
            : undefined,
          startAtEnd: false,
          onLine: async () => {
            await this.queueSubscriptionDrain();
          },
        });
        this.subscriptionController = controller;
        const currentTailCursor = this.tailCursor;
        if (currentTailCursor) {
          this.subscriptionCursor = currentTailCursor;
        } else {
          const initial = await this.readAfter(undefined);
          if (this.isSubscriptionFollowerStartupStale(startupGeneration)) {
            this.subscriptionController = null;
            return;
          }
          this.subscriptionCursor = initial.nextCursor ?? 'tail';
        }
        await controller.attach({ keepAlive: true });
        if (this.subscriptionController !== controller || this.isSubscriptionFollowerStartupStale(startupGeneration)) {
          if (this.subscriptionController === controller) {
            this.subscriptionController = null;
          }
          await controller.dispose();
        }
      } catch (error) {
        if (this.subscriptionController === controller) {
          this.subscriptionController = null;
        }
        await controller?.dispose().catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      if (this.subscriptionControllerStartupPromise === startupPromise) {
        this.subscriptionControllerStartupPromise = null;
      }
    });
    this.subscriptionControllerStartupPromise = startupPromise;
    await startupPromise;
  }

  private async stopSubscriptionFollower(): Promise<void> {
    this.subscriptionControllerStartupGeneration += 1;
    this.subscriptionControllerStartupPromise = null;
    const controller = this.subscriptionController;
    this.subscriptionController = null;
    this.subscriptionCursor = null;
    this.subscriptionDrainPromise = null;
    this.subscriptionDrainQueued = false;
    await controller?.dispose();
  }

  private shouldKeepSubscriptionFollower(): boolean {
    return this.lifecycleState === 'hot_attached' || this.subscriptionListeners.size > 0;
  }

  private isSubscriptionFollowerStartupStale(startupGeneration: number): boolean {
    return (
      this.lifecycleState === 'disposed'
      || !this.shouldKeepSubscriptionFollower()
      || this.subscriptionControllerStartupGeneration !== startupGeneration
    );
  }

  private async queueSubscriptionDrain(): Promise<void> {
    if (this.subscriptionDrainPromise) {
      this.subscriptionDrainQueued = true;
      return;
    }

    const run = async (): Promise<void> => {
      do {
        this.subscriptionDrainQueued = false;
        const update = await this.readAfter(({
          cursor: this.subscriptionCursor ?? 'tail',
          maxBytes: 1024 * 1024,
          maxItems: 100,
        } as unknown) as TReadAfterParams);
        this.subscriptionCursor = update.nextCursor ?? this.subscriptionCursor ?? 'tail';
        if (update.items.length > 0 || update.truncated) {
          await Promise.all(
            Array.from(this.subscriptionListeners).map(async (subscriptionListener) => {
              await subscriptionListener(update);
            }),
          );
        }
      } while (this.subscriptionDrainQueued && this.subscriptionListeners.size > 0);
    };

    this.subscriptionDrainPromise = run().finally(() => {
      this.subscriptionDrainPromise = null;
    });
    await this.subscriptionDrainPromise;
  }
}

export function createProjectedJsonlSessionStore<TItem, TActivity, TPageParams, TReadAfterParams, TPreview = string | null>(params: Readonly<{
  key: FileBackedTranscriptSessionStoreKey;
  operations: ProjectedJsonlSessionStoreOperations<TItem, TActivity, TPageParams, TReadAfterParams, TPreview>;
}>): FileBackedTranscriptSessionStore<TItem, TActivity, TPreview> {
  return new ProjectedJsonlSessionStore(params.key, params.operations);
}
