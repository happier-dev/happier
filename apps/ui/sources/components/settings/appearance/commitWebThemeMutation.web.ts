import { flushSync } from 'react-dom';

export async function commitWebThemeMutation(mutation: () => void): Promise<void> {
    flushSync(mutation);
}
