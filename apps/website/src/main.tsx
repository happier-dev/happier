import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import { installInitialThemeAttribute } from './theme/useTheme';

// Resolve theme BEFORE first paint so there's no flash of the wrong theme.
installInitialThemeAttribute();

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
