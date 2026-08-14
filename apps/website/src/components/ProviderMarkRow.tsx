import { useTheme } from './ThemeContext';
import { useSiteData } from '../i18n/siteData';

type ProviderMarkRowProps = Readonly<{
    justify?: 'start' | 'center';
    size?: number;
}>;

export function ProviderMarkRow(props: ProviderMarkRowProps) {
    const { providers: { PROVIDERS } } = useSiteData();

    const { theme } = useTheme();
    const justify = props.justify ?? 'start';
    const size = props.size ?? 18;
    const color = theme === 'dark' ? 'rgba(255,255,255,0.68)' : 'rgba(10,10,11,0.58)';

    return (
        <div
            className={`flex flex-nowrap items-center gap-3 overflow-hidden ${justify === 'center' ? 'justify-center' : 'justify-start'}`}
            aria-label="Supported AI coding agents"
        >
            {PROVIDERS.map((provider) => (
                <div
                    key={provider.id}
                    className="flex shrink-0 grow-0 items-center justify-center"
                    style={{ width: size, height: size, color }}
                    aria-hidden
                >
                    {provider.logo}
                </div>
            ))}
        </div>
    );
}
