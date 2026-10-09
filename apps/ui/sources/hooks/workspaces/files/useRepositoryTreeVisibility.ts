import { useRepositoryTreeBrowserState } from './repositoryTreeBrowserState';

export function useRepositoryTreeVisibility(scopeKey: string) {
    const { visibilityMode, setVisibilityMode, gitIgnoreAvailable, setGitIgnoreAvailable, revealedPaths, revealPath, latestRequest } = useRepositoryTreeBrowserState(scopeKey);
    return { visibilityMode, setVisibilityMode, gitIgnoreAvailable, setGitIgnoreAvailable, revealedPaths, revealPath, latestRequest };
}
