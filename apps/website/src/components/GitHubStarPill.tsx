import { GITHUB_REPO_URL } from '../data/downloads';
import { useSiteData } from '../i18n/siteData';
import { useGitHubStats } from './GitHubStats';
import { formatStatCount } from './publicStats';
import { RollingNumber } from './RollingNumber';

export function GitHubStarPill() {
    const { open: { OPEN_PILLS } } = useSiteData();
    const { stars } = useGitHubStats();
    return (
        <a href={GITHUB_REPO_URL} target="_blank" rel="noopener" className="plan-pill">
            <svg aria-hidden viewBox="0 0 16 16" className="h-[15px] w-[15px]" fill="currentColor">
                <path d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.4.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 0-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2Z" />
            </svg>
            {OPEN_PILLS.star}
            <span aria-hidden style={{ color: 'var(--muted)' }}>·</span>
            <span className="tabular-nums">
                <RollingNumber value={formatStatCount(stars, 'en-US')} />
            </span>
        </a>
    );
}
