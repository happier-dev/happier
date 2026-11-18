/**
 * Longest-processing-time partitioning: the heaviest item goes to the lightest
 * partition (ties: fewer items, then lower index). With equal weights this is
 * round-robin over the sorted items. Each partition is returned sorted.
 * @template T
 * @param {{ items: Iterable<T>; partitionCount: number; weightOf: (item: T) => number }} input
 * @returns {T[][]}
 */
export function partitionByWeight({ items, partitionCount, weightOf }) {
  const ranked = [...new Set(items)].sort()
    .map((item) => ({ item, weight: weightOf(item) }))
    .sort((left, right) => right.weight - left.weight || String(left.item).localeCompare(String(right.item)));
  const partitions = Array.from({ length: partitionCount }, () => ({ items: [], weight: 0 }));
  for (const entry of ranked) {
    let target = 0;
    for (let index = 1; index < partitions.length; index += 1) {
      const candidate = partitions[index];
      const selected = partitions[target];
      if (candidate.weight < selected.weight
        || (candidate.weight === selected.weight && candidate.items.length < selected.items.length)) {
        target = index;
      }
    }
    partitions[target].items.push(entry.item);
    partitions[target].weight += entry.weight;
  }
  return partitions.map((partition) => partition.items.sort());
}
