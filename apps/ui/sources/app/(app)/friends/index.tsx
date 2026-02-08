import * as React from 'react';
import { useRouter } from 'expo-router';

export default function FriendsPageRedirect() {
    const router = useRouter();

    React.useEffect(() => {
        router.replace('/inbox');
    }, [router]);

    return null;
}
