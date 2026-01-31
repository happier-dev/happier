// Theme Toggle
const themeToggle = document.getElementById('theme-toggle');
const html = document.documentElement;

function safeLocalStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function getStoredTheme() {
  const stored = safeLocalStorageGet('theme');
  return stored === 'dark' || stored === 'light' ? stored : null;
}

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Apply theme
function applyTheme(theme) {
  html.classList.toggle('dark', theme === 'dark');
}

// Initialize theme
applyTheme(getStoredTheme() ?? getSystemTheme());

// Theme toggle click handler
themeToggle?.addEventListener('click', () => {
  const currentTheme = html.classList.contains('dark') ? 'dark' : 'light';
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  safeLocalStorageSet('theme', nextTheme);
});

// Listen for system theme changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!getStoredTheme()) {
    applyTheme(e.matches ? 'dark' : 'light');
  }
});

// Mobile Menu Toggle
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const mobileMenu = document.getElementById('mobile-menu');

function setMobileMenuOpen(open) {
  if (!mobileMenuBtn || !mobileMenu) return;
  mobileMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  mobileMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
  mobileMenu.classList.toggle('hidden', !open);
}

mobileMenuBtn?.addEventListener('click', () => {
  const isOpen = mobileMenu ? !mobileMenu.classList.contains('hidden') : false;
  setMobileMenuOpen(!isOpen);
});

// Close mobile menu when clicking on a link
mobileMenu?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    setMobileMenuOpen(false);
  });
});

// Copy to clipboard functionality
function copyToClipboard(text, buttonId) {
  navigator.clipboard.writeText(text).then(() => {
    const button = document.getElementById(buttonId);
    if (button) {
      // Store original content
      const originalHTML = button.innerHTML;
      
      // Show success state
      button.innerHTML = `
        <svg class="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
        </svg>
      `;
      
      // Restore original after 2 seconds
      setTimeout(() => {
        button.innerHTML = originalHTML;
      }, 2000);
    }
    
    // Show toast notification
    showToast('Copied to clipboard!');
  }).catch((err) => {
    console.error('Failed to copy:', err);
    showToast('Failed to copy', 'error');
  });
}

// Copy install command buttons
document.getElementById('copy-install')?.addEventListener('click', () => {
  copyToClipboard('npm install -g @happier-dev/cli', 'copy-install');
});

document.getElementById('copy-install-footer')?.addEventListener('click', () => {
  copyToClipboard('npm install -g @happier-dev/cli', 'copy-install-footer');
});

// Toast notification
function showToast(message, type = 'success') {
  // Remove any existing toasts
  const existingToast = document.querySelector('.toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-enter ${type === 'success' ? 'bg-accent text-white' : 'bg-red-500 text-white'}`;
  toast.textContent = message;
  
  // Add to DOM
  document.body.appendChild(toast);
  
  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('toast-enter-active');
  });
  
  // Remove after 3 seconds
  setTimeout(() => {
    toast.classList.remove('toast-enter', 'toast-enter-active');
    toast.classList.add('toast-exit');
    toast.classList.add('toast-exit-active');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const targetId = this.getAttribute('href');
    const targetElement = document.querySelector(targetId);
    
    if (targetElement) {
      targetElement.classList.add('is-visible');
      targetElement.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      });
    }
  });
});

// Intersection Observer for progressive reveal animations
const revealElements = Array.from(document.querySelectorAll('.reveal'));

if (revealElements.length > 0) {
  if (!('IntersectionObserver' in window)) {
    revealElements.forEach((el) => el.classList.add('is-visible'));
  } else {
    const observerOptions = {
      root: null,
      rootMargin: '0px 0px -10% 0px',
      threshold: 0.1,
    };

    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, observerOptions);

    revealElements.forEach((el) => revealObserver.observe(el));
  }
}

// Feature tabs
function initFeatureTabs() {
  const buttons = Array.from(document.querySelectorAll('.feature-tab[data-feature-tab]'));
  if (buttons.length === 0) return;

  const titleEl = document.getElementById('feature-tabs-title');
  const descEl = document.getElementById('feature-tabs-desc');
  const imageEl = document.getElementById('feature-tabs-image');
  const panelEl = document.getElementById('feature-panel');
  if (!titleEl || !descEl || !imageEl || !panelEl) return;

  const tabs = {
    sessions: {
      title: 'Sessions you can trust',
      desc: 'Persistent sessions, reliable resume, and full history across devices — designed for long-running agent workflows.',
      image: '/images/screens/sessions.svg',
      alt: 'Sessions overview screenshot',
    },
    collaboration: {
      title: 'Collaborate in real time',
      desc: 'Invite teammates with private links, keep access under control, and collaborate securely end-to-end.',
      image: '/images/screens/collaboration.svg',
      alt: 'Collaboration overview screenshot',
    },
    history: {
      title: 'Infinite history, always available',
      desc: 'Search, skim, and jump back to older context instantly — from terminal to web to mobile.',
      image: '/images/screens/history.svg',
      alt: 'History overview screenshot',
    },
    queue: {
      title: 'A queue you control',
      desc: 'Edit and reorder queued prompts before the agent runs them. Stay in charge of your workflow.',
      image: '/images/screens/queue.svg',
      alt: 'Pending queue overview screenshot',
    },
    encryption: {
      title: 'Security-first by design',
      desc: 'Signal-style crypto (TweetNaCl), end-to-end encryption, and keys that never leave your devices.',
      image: '/images/screens/encryption.svg',
      alt: 'Encryption overview screenshot',
    },
    providers: {
      title: 'Choose the providers you love',
      desc: 'Claude Code, Codex, Gemini, OpenCode — plus more over time. Switch without losing your session context.',
      image: '/images/screens/providers.svg',
      alt: 'Providers overview screenshot',
    },
  };

  function setActiveTab(key, { focus = false } = {}) {
    const resolvedKey = tabs[key] ? key : 'sessions';
    const tab = tabs[resolvedKey];

    titleEl.textContent = tab.title;
    descEl.textContent = tab.desc;

    if (imageEl.getAttribute('src') !== tab.image) {
      imageEl.setAttribute('src', tab.image);
    }
    imageEl.setAttribute('alt', tab.alt);

    buttons.forEach((btn) => {
      const isActive = btn.dataset.featureTab === resolvedKey;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      btn.setAttribute('tabindex', isActive ? '0' : '-1');
      if (isActive && btn.id) panelEl.setAttribute('aria-labelledby', btn.id);
    });

    if (focus) {
      const activeBtn = buttons.find((b) => b.dataset.featureTab === resolvedKey);
      activeBtn?.focus();
    }
  }

  buttons.forEach((btn, index) => {
    btn.addEventListener('click', () => {
      setActiveTab(btn.dataset.featureTab, { focus: false });
    });

    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (index + delta + buttons.length) % buttons.length;
      const nextKey = buttons[nextIndex]?.dataset.featureTab;
      if (nextKey) setActiveTab(nextKey, { focus: true });
    });
  });

  const initialBtn = buttons.find((b) => b.getAttribute('aria-selected') === 'true') ?? buttons[0];
  const initialKey = initialBtn?.dataset.featureTab ?? 'sessions';
  setActiveTab(initialKey);
}

initFeatureTabs();

// Navbar scroll effect
let lastScrollY = window.scrollY;
const navbar = document.querySelector('nav');

window.addEventListener('scroll', () => {
  const currentScrollY = window.scrollY;
  
  // Add shadow when scrolled
  if (currentScrollY > 10) {
    navbar?.classList.add('shadow-md');
  } else {
    navbar?.classList.remove('shadow-md');
  }
  
  lastScrollY = currentScrollY;
});

// Keyboard navigation support
document.addEventListener('keydown', (e) => {
  // Toggle theme with 'T' key
  if (e.key === 't' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    themeToggle?.click();
  }
  
  // Close mobile menu with Escape
  if (e.key === 'Escape') {
    setMobileMenuOpen(false);
  }
});

// Preload images for better UX
const imagesToPreload = [
  '/images/logotype-dark.png',
  '/images/logotype-light.png',
];

imagesToPreload.forEach((src) => {
  const img = new Image();
  img.src = src;
});

console.log('🎉 Happier website loaded successfully!');
