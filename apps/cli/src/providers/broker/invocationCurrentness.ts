/** Admitted requests consume the route's local lifetime; its push owner withdraws it. */
export async function isRetainedManagedProviderInvocationCurrent(
  input: Readonly<{ readsRetainedAuthorityCurrent(): boolean }>,
): Promise<boolean> {
  try {
    return input.readsRetainedAuthorityCurrent();
  } catch {
    return false;
  }
}

export async function isManagedProviderSessionInvocationCurrent(
  input: Readonly<{
    adoptionCommitted(): boolean;
    revalidateInitialPolicy(): Promise<boolean>;
    readsRetainedAuthorityCurrent(): boolean;
  }>,
): Promise<boolean> {
  if (!input.adoptionCommitted()) {
    return (
      (await input.revalidateInitialPolicy()) === true &&
      !input.adoptionCommitted()
    );
  }
  return await isRetainedManagedProviderInvocationCurrent({
    readsRetainedAuthorityCurrent: input.readsRetainedAuthorityCurrent,
  });
}
