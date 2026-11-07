type Materialization = Readonly<{ activeServerDir: string }>;
type Listener = (materialization: Materialization) => Promise<void>;

const listeners = new Set<Listener>();

/** A completed home refresh can supersede a captured Account settings snapshot. */
export async function notifyProviderAccountSettingsMaterialization(materialization: Materialization): Promise<void> {
  await Promise.all([...listeners].map(listener => listener(materialization)));
}

export function subscribeProviderAccountSettingsMaterializations(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
