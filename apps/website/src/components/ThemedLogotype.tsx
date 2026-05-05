import { cn } from '@/utils/cn';

type ThemedLogotypeProps = {
    className?: string;
    imageClassName?: string;
};

export function ThemedLogotype({
    className,
    imageClassName,
}: ThemedLogotypeProps) {
    return (
        <span
            data-theme-logotype
            aria-hidden="true"
            className={cn('relative inline-flex shrink-0 items-center', className)}
        >
            <img
                src="/images/logotype-dark.png"
                alt=""
                aria-hidden="true"
                className={cn('theme-logotype theme-logotype-on-light', imageClassName)}
            />
            <img
                src="/images/logotype-light.png"
                alt=""
                aria-hidden="true"
                className={cn(
                    'theme-logotype theme-logotype-on-dark absolute inset-0',
                    imageClassName,
                )}
            />
        </span>
    );
}
