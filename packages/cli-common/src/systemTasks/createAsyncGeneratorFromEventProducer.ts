type QueueItem<TEvent, TResult> =
  | Readonly<{ type: 'event'; value: TEvent }>
  | Readonly<{ type: 'return'; value: TResult }>
  | Readonly<{ type: 'error'; error: unknown }>;

class AsyncQueue<T> {
  private items: T[] = [];

  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.items.push(value);
  }

  async shift(): Promise<T> {
    const next = this.items.shift();
    if (typeof next !== 'undefined') {
      return next;
    }
    return await new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export function createAsyncGeneratorFromEventProducer<TEvent, TResult>(
  producer: (emit: (event: TEvent) => void) => Promise<TResult>,
): AsyncGenerator<TEvent, TResult, void> {
  const queue = new AsyncQueue<QueueItem<TEvent, TResult>>();

  const emit = (event: TEvent) => {
    queue.push({ type: 'event', value: event });
  };

  void Promise.resolve()
    .then(() => producer(emit))
    .then(
      (value) => {
        queue.push({ type: 'return', value });
      },
      (error) => {
        queue.push({ type: 'error', error });
      },
    );

  return (async function* drain() {
    while (true) {
      const item = await queue.shift();
      if (item.type === 'event') {
        yield item.value;
        continue;
      }
      if (item.type === 'error') {
        throw item.error;
      }
      return item.value;
    }
  })();
}
