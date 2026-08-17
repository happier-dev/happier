export type GithubObservationRequestV1 = Readonly<{
  credentialRef: string;
  repositoryId: string;
  endpointKind: 'issueComments' | 'repositoryEvents';
  daemonMaterializationRef: string;
  url: string;
  page: number;
  etag: string | null;
}>;

function keyForRequest(input: GithubObservationRequestV1): string {
  if (!Number.isSafeInteger(input.page) || input.page < 1) {
    throw new RangeError('GitHub observation request pages must be positive safe integers');
  }
  return JSON.stringify([
    input.credentialRef,
    input.repositoryId,
    input.endpointKind,
    input.daemonMaterializationRef,
    input.url,
    input.page,
    input.etag,
  ]);
}

/**
 * Cycle-local memoization for one authenticated GitHub request.
 *
 * The owner constructs a fresh coalescer for each completed observer cycle.
 * Keeping settled promises here prevents a slower same-key source from issuing
 * a duplicate request after the first source has already completed.
 * It intentionally accepts no per-definition AbortSignal: cancelling one
 * definition must not abort a shared request still required by another.
 */
export class GithubObservationRequestCoalescer {
  readonly #requests = new Map<string, Promise<unknown>>();

  get requestCount(): number {
    return this.#requests.size;
  }

  run(input: GithubObservationRequestV1, perform: () => Promise<unknown>): Promise<unknown> {
    const key = keyForRequest(input);
    const existing = this.#requests.get(key);
    if (existing) return existing;

    let resolvePending: (value: unknown) => void = () => {};
    let rejectPending: (reason?: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    this.#requests.set(key, pending);

    try {
      void perform().then(resolvePending, rejectPending);
    } catch (error) {
      rejectPending(error);
    }
    return pending;
  }
}
