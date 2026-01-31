export async function runWithConcurrencyLimit({ items, limit, fn }) {
  const list = Array.isArray(items) ? items : [];
  const max = Number(limit);
  const concurrency = Number.isFinite(max) && max > 0 ? Math.floor(max) : 4;

  const results = new Array(list.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, list.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

