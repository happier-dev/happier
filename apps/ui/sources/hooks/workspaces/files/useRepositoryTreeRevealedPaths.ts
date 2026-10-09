import { useRepositoryTreeBrowserState } from './repositoryTreeBrowserState';

export function useRepositoryTreeRevealedPaths(scopeKey: string) {
    const { revealedPaths: paths, revealPath, latestRequest } = useRepositoryTreeBrowserState(scopeKey);
    return { paths, revealPath, latestRequest };
}
