export async function commitWebThemeMutation(mutation: () => void): Promise<void> {
    mutation();
}
