import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Link from 'fumadocs-core/link';
import Image from 'next/image';
import type { ComponentProps } from 'react';

function NavTitle(props: ComponentProps<'a'>) {
  const { className, ...rest } = props;
  return (
    <Link
      {...rest}
      aria-label="Happier Docs"
      className={['flex items-center', className].filter(Boolean).join(' ')}
    >
      <Image
        src="/brand/logotype-dark.png"
        alt="Happier"
        width={120}
        height={20}
        className="h-7 w-auto dark:hidden"
        priority
      />
      <Image
        src="/brand/logotype-light.png"
        alt="Happier"
        width={120}
        height={20}
        className="hidden h-7 w-auto dark:block"
        priority
      />
    </Link>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: NavTitle,
    },
  };
}
